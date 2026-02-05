/**
 * Firebase Cloud Functions for bureaucRatis Admin Operations
 * 
 * Server-side functions for admin-only operations that require
 * elevated privileges (Firebase Admin SDK).
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

// Your admin email - ONLY this user can call admin functions
const ADMIN_EMAIL = "codingsprint.com@gmail.com";
const APP_ID = "fluency-flow-standalone";

/**
 * Verify if the calling user is an admin
 */
async function verifyAdmin(context) {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }
    
    const callerEmail = context.auth.token.email;
    if (callerEmail !== ADMIN_EMAIL) {
        throw new functions.https.HttpsError("permission-denied", "Only admin can perform this action.");
    }
    
    return true;
}

/**
 * Delete a user completely (Firebase Auth + all Firestore data)
 * 
 * Call from client:
 * const deleteUser = firebase.functions().httpsCallable('deleteUserCompletely');
 * await deleteUser({ userId: 'user-uid-here' });
 */
exports.deleteUserCompletely = functions.https.onCall(async (data, context) => {
    // Verify admin
    await verifyAdmin(context);
    
    const { userId } = data;
    if (!userId) {
        throw new functions.https.HttpsError("invalid-argument", "User ID is required.");
    }
    
    // Prevent admin from deleting themselves
    if (userId === context.auth.uid) {
        throw new functions.https.HttpsError("invalid-argument", "Cannot delete your own account.");
    }
    
    const results = {
        authDeleted: false,
        postsDeleted: 0,
        vocabularyDeleted: 0,
        conversationsDeleted: 0,
        friendsRemoved: 0,
        errors: [],
    };
    
    try {
        // 1. Delete user's posts and their comments
        const postsSnapshot = await db.collection("artifacts").doc(APP_ID)
            .collection("peerPosts")
            .where("authorId", "==", userId)
            .get();
        
        for (const postDoc of postsSnapshot.docs) {
            // Delete comments first
            const commentsSnapshot = await postDoc.ref.collection("comments").get();
            for (const commentDoc of commentsSnapshot.docs) {
                await commentDoc.ref.delete();
            }
            await postDoc.ref.delete();
            results.postsDeleted++;
        }
        
        // 2. Delete user's comments on other posts
        const allPostsSnapshot = await db.collection("artifacts").doc(APP_ID)
            .collection("peerPosts")
            .get();
        
        for (const postDoc of allPostsSnapshot.docs) {
            const userComments = await postDoc.ref.collection("comments")
                .where("authorId", "==", userId)
                .get();
            
            for (const commentDoc of userComments.docs) {
                await commentDoc.ref.delete();
                // Update comment count on the post
                const currentCount = postDoc.data().commentCount || 0;
                await postDoc.ref.update({ commentCount: Math.max(0, currentCount - 1) });
            }
        }
        
        // 3. Delete user's vocabulary
        const vocabSnapshot = await db.collection("artifacts").doc(APP_ID)
            .collection("users").doc(userId)
            .collection("vocabulary")
            .get();
        
        for (const vocabDoc of vocabSnapshot.docs) {
            await vocabDoc.ref.delete();
            results.vocabularyDeleted++;
        }
        
        // 4. Delete user's metadata
        try {
            await db.collection("artifacts").doc(APP_ID)
                .collection("users").doc(userId)
                .collection("metadata").doc("stats")
                .delete();
        } catch (err) {
            results.errors.push("Could not delete metadata: " + err.message);
        }
        
        // 5. Delete user's profile
        try {
            await db.collection("artifacts").doc(APP_ID)
                .collection("users").doc(userId)
                .collection("profile").doc("info")
                .delete();
        } catch (err) {
            results.errors.push("Could not delete profile: " + err.message);
        }
        
        // 6. Delete from chatUsers collection
        try {
            // Delete friends subcollection
            const friendsSnapshot = await db.collection("artifacts").doc(APP_ID)
                .collection("chatUsers").doc(userId)
                .collection("friends")
                .get();
            
            for (const friendDoc of friendsSnapshot.docs) {
                // Also remove this user from friend's friends list
                try {
                    await db.collection("artifacts").doc(APP_ID)
                        .collection("chatUsers").doc(friendDoc.id)
                        .collection("friends").doc(userId)
                        .delete();
                } catch (e) {
                    // Ignore
                }
                await friendDoc.ref.delete();
                results.friendsRemoved++;
            }
            
            // Delete friend requests
            const requestsSnapshot = await db.collection("artifacts").doc(APP_ID)
                .collection("chatUsers").doc(userId)
                .collection("friendRequests")
                .get();
            for (const reqDoc of requestsSnapshot.docs) {
                await reqDoc.ref.delete();
            }
            
            // Delete sent requests
            const sentSnapshot = await db.collection("artifacts").doc(APP_ID)
                .collection("chatUsers").doc(userId)
                .collection("sentRequests")
                .get();
            for (const sentDoc of sentSnapshot.docs) {
                // Remove from recipient's friendRequests
                try {
                    await db.collection("artifacts").doc(APP_ID)
                        .collection("chatUsers").doc(sentDoc.id)
                        .collection("friendRequests").doc(userId)
                        .delete();
                } catch (e) {
                    // Ignore
                }
                await sentDoc.ref.delete();
            }
            
            // Delete share requests
            const shareReqSnapshot = await db.collection("artifacts").doc(APP_ID)
                .collection("chatUsers").doc(userId)
                .collection("shareRequests")
                .get();
            for (const shareDoc of shareReqSnapshot.docs) {
                await shareDoc.ref.delete();
            }
            
            // Delete the chatUser document itself
            await db.collection("artifacts").doc(APP_ID)
                .collection("chatUsers").doc(userId)
                .delete();
                
        } catch (err) {
            results.errors.push("Error cleaning chatUsers: " + err.message);
        }
        
        // 7. Handle conversations - delete messages from this user or entire conversation
        const conversationsSnapshot = await db.collection("artifacts").doc(APP_ID)
            .collection("conversations")
            .where("participants", "array-contains", userId)
            .get();
        
        for (const convoDoc of conversationsSnapshot.docs) {
            // Delete all messages in the conversation
            const messagesSnapshot = await convoDoc.ref.collection("messages").get();
            for (const msgDoc of messagesSnapshot.docs) {
                await msgDoc.ref.delete();
            }
            // Delete the conversation
            await convoDoc.ref.delete();
            results.conversationsDeleted++;
        }
        
        // 8. Finally, delete the Firebase Auth user
        try {
            await auth.deleteUser(userId);
            results.authDeleted = true;
        } catch (err) {
            results.errors.push("Could not delete Auth user: " + err.message);
        }
        
        return {
            success: true,
            message: `User ${userId} deleted successfully.`,
            details: results,
        };
        
    } catch (error) {
        console.error("Error deleting user:", error);
        throw new functions.https.HttpsError("internal", "Error deleting user: " + error.message);
    }
});

/**
 * Ban a user by disabling their Firebase Auth account
 * (User cannot log in but data is preserved)
 */
exports.banUser = functions.https.onCall(async (data, context) => {
    await verifyAdmin(context);
    
    const { userId, reason } = data;
    if (!userId) {
        throw new functions.https.HttpsError("invalid-argument", "User ID is required.");
    }
    
    // Prevent admin from banning themselves
    if (userId === context.auth.uid) {
        throw new functions.https.HttpsError("invalid-argument", "Cannot ban your own account.");
    }
    
    try {
        // Disable the user's account
        await auth.updateUser(userId, { disabled: true });
        
        // Optionally store ban info in Firestore
        await db.collection("artifacts").doc(APP_ID)
            .collection("bannedUsers").doc(userId)
            .set({
                bannedAt: admin.firestore.FieldValue.serverTimestamp(),
                bannedBy: context.auth.uid,
                reason: reason || "No reason provided",
            });
        
        return { success: true, message: `User ${userId} has been banned.` };
        
    } catch (error) {
        console.error("Error banning user:", error);
        throw new functions.https.HttpsError("internal", "Error banning user: " + error.message);
    }
});

/**
 * Unban a user by re-enabling their Firebase Auth account
 */
exports.unbanUser = functions.https.onCall(async (data, context) => {
    await verifyAdmin(context);
    
    const { userId } = data;
    if (!userId) {
        throw new functions.https.HttpsError("invalid-argument", "User ID is required.");
    }
    
    try {
        await auth.updateUser(userId, { disabled: false });
        
        // Remove from banned users collection
        await db.collection("artifacts").doc(APP_ID)
            .collection("bannedUsers").doc(userId)
            .delete();
        
        return { success: true, message: `User ${userId} has been unbanned.` };
        
    } catch (error) {
        console.error("Error unbanning user:", error);
        throw new functions.https.HttpsError("internal", "Error unbanning user: " + error.message);
    }
});

/**
 * Get statistics for admin dashboard
 */
exports.getAdminStats = functions.https.onCall(async (data, context) => {
    await verifyAdmin(context);

    try {
        const [usersSnapshot, postsSnapshot, conversationsSnapshot] = await Promise.all([
            db.collection("artifacts").doc(APP_ID).collection("chatUsers").get(),
            db.collection("artifacts").doc(APP_ID).collection("peerPosts").get(),
            db.collection("artifacts").doc(APP_ID).collection("conversations").get(),
        ]);

        return {
            totalUsers: usersSnapshot.size,
            totalPosts: postsSnapshot.size,
            totalConversations: conversationsSnapshot.size,
        };

    } catch (error) {
        console.error("Error getting stats:", error);
        throw new functions.https.HttpsError("internal", "Error getting stats: " + error.message);
    }
});

/**
 * Migrate all Firebase Auth users to chatUsers collection
 * This is a one-time migration function to backfill existing users
 *
 * Call from client (admin only):
 * const migrateUsers = firebase.functions().httpsCallable('migrateAuthUsersToChatUsers');
 * await migrateUsers();
 */
exports.migrateAuthUsersToChatUsers = functions.https.onCall(async (data, context) => {
    await verifyAdmin(context);

    const results = {
        totalAuthUsers: 0,
        alreadyExisted: 0,
        newlyCreated: 0,
        errors: [],
    };

    try {
        // List all users from Firebase Auth (handles pagination automatically)
        const listAllUsers = async (nextPageToken) => {
            const listUsersResult = await auth.listUsers(1000, nextPageToken);

            for (const userRecord of listUsersResult.users) {
                results.totalAuthUsers++;

                try {
                    const chatUserRef = db.collection("artifacts").doc(APP_ID)
                        .collection("chatUsers").doc(userRecord.uid);

                    const existingDoc = await chatUserRef.get();

                    if (existingDoc.exists) {
                        // User already exists in chatUsers, just update profile info
                        await chatUserRef.update({
                            displayName: userRecord.displayName || existingDoc.data().displayName || "Anonymous",
                            photoURL: userRecord.photoURL || existingDoc.data().photoURL || "",
                            email: userRecord.email || existingDoc.data().email || "",
                            lastSeen: Date.now(),
                        });
                        results.alreadyExisted++;
                    } else {
                        // New user - create document
                        await chatUserRef.set({
                            uid: userRecord.uid,
                            displayName: userRecord.displayName || "Anonymous",
                            photoURL: userRecord.photoURL || "",
                            email: userRecord.email || "",
                            createdAt: userRecord.metadata.creationTime
                                ? new Date(userRecord.metadata.creationTime).getTime()
                                : Date.now(),
                            lastSeen: userRecord.metadata.lastSignInTime
                                ? new Date(userRecord.metadata.lastSignInTime).getTime()
                                : Date.now(),
                            migratedAt: Date.now(),
                        });
                        results.newlyCreated++;
                    }
                } catch (err) {
                    results.errors.push({
                        uid: userRecord.uid,
                        email: userRecord.email,
                        error: err.message,
                    });
                }
            }

            // If there are more users, continue pagination
            if (listUsersResult.pageToken) {
                await listAllUsers(listUsersResult.pageToken);
            }
        };

        await listAllUsers();

        return {
            success: true,
            message: `Migration completed. ${results.newlyCreated} new users added, ${results.alreadyExisted} already existed.`,
            details: results,
        };

    } catch (error) {
        console.error("Error during migration:", error);
        throw new functions.https.HttpsError("internal", "Migration error: " + error.message);
    }
});

/**
 * Automatically add new Firebase Auth users to chatUsers collection
 * This triggers whenever a new user is created in Firebase Auth
 */
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
    try {
        const chatUserRef = db.collection("artifacts").doc(APP_ID)
            .collection("chatUsers").doc(user.uid);

        await chatUserRef.set({
            uid: user.uid,
            displayName: user.displayName || "Anonymous",
            photoURL: user.photoURL || "",
            email: user.email || "",
            createdAt: Date.now(),
            lastSeen: Date.now(),
        });

        console.log(`New user ${user.uid} (${user.email}) added to chatUsers`);
        return null;
    } catch (error) {
        console.error("Error adding new user to chatUsers:", error);
        return null;
    }
});
